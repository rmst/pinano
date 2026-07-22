// Agent runtime boundary used by service/server code.
//
// A runtime may be an in-process Agent or a proxy to a worker process. The
// service-side SessionRuntime intentionally depends on this small behavioral
// surface rather than on where the agent loop executes.

/**
 * @typedef {object} AgentRuntime
 * @property {any} state Mutable live state mirrored from the agent loop.
 * @property {string | undefined} sessionId
 * @property {any} session
 * @property {WeakMap<object, string>} msgToEntryId
 * @property {any} streamFn Service-side stream function for service-owned model tasks.
 * @property {(messages: any[], signal?: AbortSignal) => any[] | Promise<any[]>} [resolveModelInputAttachments]
 * @property {boolean} [isDead] True when a process-backed runtime can no longer accept commands.
 * @property {(listener: (event: any, signal: AbortSignal) => void | Promise<void>) => () => void} subscribe
 * @property {(listener: (message: any) => void | Promise<void>) => () => void} subscribeCompaction
 * @property {(input: any) => { messages: any[], accepted: Promise<void>, run: Promise<void> }} startPrompt
 * @property {(input: any) => Promise<void>} [prompt]
 * @property {() => Promise<void>} continue
 * @property {(input: any, options?: any) => Promise<void>} [runSidecarPrompt]
 * @property {(options: { scope: any, messages: any[], transformContext?: any, afterToolCall?: any }) => AgentRuntime} [createSidecarAgent]
 * @property {(request: any) => Promise<any>} [pinanoApiRequest]
 * @property {() => any} [pinanoApiForTool]
 * @property {() => any} [pinanoApiScopeForTool]
 * @property {any} [pinanoApi]
 * @property {(messages: any[], run: Promise<void>) => Promise<void>} [waitForMessagesAccepted]
 * @property {(message: any) => void} steer
 * @property {(message: any) => void} followUp
 * @property {() => void} [clearSteeringQueue]
 * @property {() => void} [clearFollowUpQueue]
 * @property {() => void} [clearAllQueues]
 * @property {() => void} abort
 * @property {() => Promise<void>} waitForIdle
 * @property {() => Array<{ behavior: "steer" | "followUp", message: any }>} [getQueuedMessages]
 * @property {() => boolean} [hasBackgroundWork]
 * @property {() => Promise<void>} [waitForBackgroundWork]
 * @property {() => any} softInterrupt
 * @property {() => void} [reset]
 * @property {() => void} [dispose]
 * @property {(keepLast?: number) => Promise<any>} [compact]
 */

export {}
