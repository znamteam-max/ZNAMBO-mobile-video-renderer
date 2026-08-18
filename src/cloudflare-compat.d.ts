// Minimal compatibility declarations for Cloudflare runtime helper types that are
// used by the application but are not emitted by `wrangler types --include-runtime=false`.
// These are TypeScript-only declarations and have no runtime effect.

interface R2UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

type QueueRetryOptions = {
  delaySeconds?: number;
};

interface QueueMessage<Body = unknown> {
  readonly body: Body;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}

interface ExportedHandler<Env = unknown, QueueHandlerMessage = unknown> {
  fetch?: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>;
  queue?: (
    batch: MessageBatch<QueueHandlerMessage>,
    env: Env,
    ctx: ExecutionContext,
  ) => void | Promise<void>;
}
