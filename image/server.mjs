import { createServer } from 'node:http';

const hookPaths = new Set([
  '/aws/lambda-microvms/runtime/v1/ready',
  '/aws/lambda-microvms/runtime/v1/validate',
]);

const server = createServer((request, response) => {
  request.resume();
  const path = request.url.split('?')[0];
  const knownPath = path === '/health' || hookPaths.has(path);
  const allowedMethod = request.method === 'GET' ||
    (hookPaths.has(path) && request.method === 'POST');
  const statusCode = !knownPath ? 404 : !allowedMethod ? 405 : 200;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(statusCode === 405 ? { Allow: hookPaths.has(path) ? 'GET, POST' : 'GET' } : {}),
  });
  response.end(JSON.stringify({ status: statusCode === 200 ? 'ok' : 'error' }));
});

server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => {
  const address = server.address();
  console.log(JSON.stringify({ event: 'listening', port: address.port }));
});
