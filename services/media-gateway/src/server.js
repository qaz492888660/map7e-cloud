import http from 'node:http'
import { createMediaGatewayHandler } from './gateway.js'

const port = Number.parseInt(process.env.PORT || '8080', 10)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port')

const server = http.createServer(createMediaGatewayHandler())
server.requestTimeout = 0
server.headersTimeout = 30_000
server.keepAliveTimeout = 5_000
server.listen(port, '0.0.0.0', () => console.info(JSON.stringify({ event: 'media_gateway_started', port })))

function stop() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
