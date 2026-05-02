import 'dotenv/config'
import { buildApp } from './app'

const port = Number(process.env.API_PORT ?? 8787)
const host = process.env.API_HOST ?? '127.0.0.1'
const app = buildApp()

try {
  await app.listen({ port, host })
  console.log(`ChapterLens API listening on http://${host}:${port}`)
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
