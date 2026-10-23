// Durable mirror state in the plugin's kv store.
//
// binding:<threadId>          → Binding
// slack:<channelId>:<rootTs>  → threadId (reverse lookup for replies)
import { z } from "zod";

const CardSchema = z.object({
  ts: z.string().min(1),
  kind: z.enum(["approval", "question", "other"]),
});

export const BindingSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  channelId: z.string().min(1),
  /** Slack thread root: the plugin's status card, or the DM that started the thread. */
  rootTs: z.string().min(1),
  /** The status card, updated in place. Equals rootTs unless the thread started from a DM. */
  cardTs: z.string().min(1),
  enabled: z.boolean(),
  /** Last thread event sequence mirrored into Slack. */
  lastSeq: z.number().int().nonnegative(),
  createdAt: z.number(),
  /** Open interaction cards by interaction id. */
  cards: z.record(z.string(), CardSchema).default({}),
});
export type Binding = z.infer<typeof BindingSchema>;
export type InteractionCard = z.infer<typeof CardSchema>;

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

const bindingKey = (threadId: string) => `binding:${threadId}`;
const slackKey = (channelId: string, rootTs: string) => `slack:${channelId}:${rootTs}`;

export class BindingStore {
  readonly #kv: KvStore;

  constructor(kv: KvStore) {
    this.#kv = kv;
  }

  async get(threadId: string): Promise<Binding | undefined> {
    const raw = await this.#kv.get<unknown>(bindingKey(threadId));
    const parsed = BindingSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  async bySlackThread(channelId: string, rootTs: string): Promise<Binding | undefined> {
    const threadId = await this.#kv.get<string>(slackKey(channelId, rootTs));
    return typeof threadId === "string" ? this.get(threadId) : undefined;
  }

  async save(binding: Binding): Promise<void> {
    await this.#kv.set(bindingKey(binding.threadId), binding);
    await this.#kv.set(slackKey(binding.channelId, binding.rootTs), binding.threadId);
  }

  async remove(binding: Binding): Promise<void> {
    await this.#kv.delete(bindingKey(binding.threadId));
    await this.#kv.delete(slackKey(binding.channelId, binding.rootTs));
  }

  async list(): Promise<Binding[]> {
    const keys = await this.#kv.list("binding:");
    const ids = keys.map((key) => (key.startsWith("binding:") ? key.slice("binding:".length) : key));
    const bindings = await Promise.all(ids.map((threadId) => this.get(threadId)));
    return bindings.filter((binding): binding is Binding => binding !== undefined);
  }
}
