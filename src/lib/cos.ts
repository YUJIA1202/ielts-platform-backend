import COS from 'cos-nodejs-sdk-v5'
import path from 'path'

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID!,
  SecretKey: process.env.COS_SECRET_KEY!,
})

const BUCKET = process.env.COS_BUCKET!
const REGION = process.env.COS_REGION!

export async function uploadToCOS(
  fileBuffer: Buffer,
  filename: string,
  folder: string
): Promise<string> {
  const key = `${folder}/${Date.now()}_${filename}`
  
  await cos.putObject({
    Bucket: BUCKET,
    Region: REGION,
    Key: key,
    Body: fileBuffer,
  })

  return `https://${BUCKET}.cos.${REGION}.myqcloud.com/${key}`
}