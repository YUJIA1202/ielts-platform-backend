# 雅思写作平台 — 后端

Express + TypeScript + MySQL 搭建的 RESTful API 服务。

## 技术栈

- Node.js / Express / TypeScript
- MySQL + Prisma（版本化迁移）
- JWT 鉴权 + bcrypt 密码加密
- multer 文件上传（Word/PDF/视频）
- Puppeteer 服务端生成带水印 PDF

## 主要功能

- 用户注册登录，三级权限控制（免费 / 基础 / 高级）
- 题目、范文、视频的增删改查
- 管理员上传 Word/PDF 资料与视频资源
- 订阅套餐与订单管理
- 用户管理（查看、封禁、权限调整）
- 用户意见反馈查看与处理
- 用户提交作文批改的管理与回复

## 本地运行
1. 安装依赖：`npm install`
2. 配置 `.env`（参考下方）
3. 执行数据库迁移：`npx prisma migrate dev`
4. 启动服务：`npm run dev`

## 环境变量
```env
DATABASE_URL=mysql://用户名:密码@localhost:3306/ielts_platform
JWT_SECRET=自定义密钥
BASE_URL=http://localhost:4000
```

## 相关仓库

前端：[ielts-platform-frontend](https://github.com/YUJIA1202/ielts-platform-frontend)