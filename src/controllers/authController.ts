import { Request, Response } from 'express'
import prisma from '../prisma'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production'
const MAX_DEVICES = 2
const MAX_FAIL_COUNT = 5
const IP_MAX_REGISTERS = 3

const smsCodes: Record<string, { code: string; expiresAt: number }> = {}
const loginFailCounts: Record<string, { count: number; lockedAt?: number; lockLevel: number }> = {}

function getLockDuration(lockLevel: number): number {
  switch (lockLevel) {
    case 1: return 5 * 60 * 1000
    case 2: return 10 * 60 * 1000
    case 3: return 60 * 60 * 1000
    default: return 2 * 60 * 60 * 1000
  }
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

function recordFailure(key: string): { count: number; locked: boolean; lockMinutes: number } {
  if (!loginFailCounts[key]) loginFailCounts[key] = { count: 0, lockLevel: 0 }
  loginFailCounts[key].count += 1
  const count = loginFailCounts[key].count

  if (count > MAX_FAIL_COUNT) {
    loginFailCounts[key].lockLevel += 1
    loginFailCounts[key].lockedAt = Date.now()
    const duration = getLockDuration(loginFailCounts[key].lockLevel)
    const lockMinutes = Math.round(duration / 60000)
    return { count, locked: true, lockMinutes }
  }

  return { count, locked: false, lockMinutes: 0 }
}

function setTokenCookie(res: Response, token: string) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

export const sendCode = async (req: Request, res: Response) => {
  const { phone } = req.body
  if (!phone) { res.status(400).json({ error: '请输入手机号' }); return }
  const code = Math.floor(100000 + Math.random() * 900000).toString()
  smsCodes[phone] = { code, expiresAt: Date.now() + 5 * 60 * 1000 }
  console.log(`验证码 [${phone}]: ${code}`)
  res.json({ message: '验证码已发送' })
}

export const register = async (req: Request, res: Response) => {
  const { phone, code, username, password } = req.body
  const ip = getClientIp(req)

  const ipCount = await prisma.user.count({ where: { registrationIp: ip } })
  if (ipCount >= IP_MAX_REGISTERS) {
    res.status(429).json({ error: '该网络注册账号已达上限（最多3个），如有问题请联系客服' })
    return
  }

  const record = smsCodes[phone]
  if (!record || record.code !== code || Date.now() > record.expiresAt) {
    res.status(400).json({ error: '验证码错误或已过期' }); return
  }

  const existing = await prisma.user.findUnique({ where: { phone } })
  if (existing) { res.status(400).json({ error: '该手机号已注册' }); return }

  const hashedPassword = password ? await bcrypt.hash(password, 10) : null
  const user = await prisma.user.create({
    data: { phone, username, password: hashedPassword, registrationIp: ip },
  })
  delete smsCodes[phone]

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' })
  const deviceId = `${ip}-${Date.now()}`
  await prisma.loginSession.create({ data: { userId: user.id, token, deviceId } })

  setTokenCookie(res, token)
  res.json({ token, user })
}

export const login = async (req: Request, res: Response) => {
  const { phone, code } = req.body
  const ip = getClientIp(req)

  const record = smsCodes[phone]
  if (!record || record.code !== code || Date.now() > record.expiresAt) {
    res.status(400).json({ error: '验证码错误或已过期' }); return
  }

  const user = await prisma.user.findUnique({ where: { phone } })
  if (!user) { res.status(404).json({ error: '用户不存在，请先注册' }); return }
  delete smsCodes[phone]

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' })
  await handleDeviceSession(user.id, token, ip)

  setTokenCookie(res, token)
  res.json({ token, user })
}

export const loginPassword = async (req: Request, res: Response) => {
  const { phone, password } = req.body
  const ip = getClientIp(req)
  const failKey = `fail:${phone}`

  const failRecord = loginFailCounts[failKey]
  if (failRecord?.lockedAt) {
    const duration = getLockDuration(failRecord.lockLevel)
    const unlockTime = failRecord.lockedAt + duration
    if (Date.now() < unlockTime) {
      const remaining = Math.ceil((unlockTime - Date.now()) / 60000)
      const unit = remaining >= 60 ? `${Math.ceil(remaining / 60)} 小时` : `${remaining} 分钟`
      res.status(429).json({
        error: `登录失败次数过多，请 ${unit} 后再试`,
        locked: true,
        remainingMinutes: remaining,
      })
      return
    } else {
      loginFailCounts[failKey].count = MAX_FAIL_COUNT
      loginFailCounts[failKey].lockedAt = undefined
    }
  }

  const user = await prisma.user.findUnique({ where: { phone } })
  if (!user || !user.password) {
    const result = recordFailure(failKey)
    if (result.locked) {
      const unit = result.lockMinutes >= 60 ? `${Math.ceil(result.lockMinutes / 60)} 小时` : `${result.lockMinutes} 分钟`
      res.status(429).json({
        error: `验证失败，请 ${unit} 后再试`,
        locked: true,
        remainingMinutes: result.lockMinutes,
      })
      return
    }
    res.status(401).json({
      error: '手机号或密码错误',
      failCount: result.count,
      needCaptcha: result.count >= MAX_FAIL_COUNT,
    })
    return
  }

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) {
    const result = recordFailure(failKey)
    if (result.locked) {
      const unit = result.lockMinutes >= 60 ? `${Math.ceil(result.lockMinutes / 60)} 小时` : `${result.lockMinutes} 分钟`
      res.status(429).json({
        error: `验证失败，请 ${unit} 后再试`,
        locked: true,
        remainingMinutes: result.lockMinutes,
      })
      return
    }
    res.status(401).json({
      error: '手机号或密码错误',
      failCount: result.count,
      needCaptcha: result.count >= MAX_FAIL_COUNT,
    })
    return
  }

  delete loginFailCounts[failKey]

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' })
  await handleDeviceSession(user.id, token, ip)

  setTokenCookie(res, token)
  res.json({ token, user })
}

async function handleDeviceSession(userId: number, token: string, ip: string) {
  const sessions = await prisma.loginSession.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' }
  })
  if (sessions.length >= MAX_DEVICES) {
    await prisma.loginSession.delete({ where: { id: sessions[0].id } })
  }
  const deviceId = `${ip}-${Date.now()}`
  await prisma.loginSession.create({ data: { userId, token, deviceId } })
}

export const getMe = async (req: Request, res: Response) => {
  const userId = (req as any).userId
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) { res.status(404).json({ error: '用户不存在' }); return }
  res.json(user)
}

export const logout = async (req: Request, res: Response) => {
  res.clearCookie('token')
  res.json({ success: true })
}