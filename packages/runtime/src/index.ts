/**
 * @pounce/runtime — the daemon compatibility/adapter layer.
 *
 * Public surface: the PounceRuntime facade + transports. The app depends only
 * on PounceRuntime and the @pounce/shared domain types; wire details stay here.
 */
export { PounceRuntime } from "./client";
export type { SendMessageInput } from "./client";
export { PounceAdapter } from "./adapter/pounceAdapter";
export { translate, HANDLED_WIRE_TYPES } from "./adapter/translate";
export { HttpTransport, TransportError } from "./transport/httpTransport";
export type { HttpTransportConfig } from "./transport/httpTransport";
export type {
  Transport,
  ConnectionState,
  SubscribeOptions,
} from "./transport/types";
