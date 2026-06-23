export class BadRequestError extends Error {
  readonly statusCode = 400;
}

export class AgentTimeoutError extends Error {
  readonly statusCode = 504;
}

