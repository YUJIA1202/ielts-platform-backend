import dotenv from 'dotenv'

// Load the project environment before controllers and authentication middleware
// capture process.env values during module initialization.
dotenv.config({ override: false })

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production')
}

export const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production'
