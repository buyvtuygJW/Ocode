import type { Message } from "@opencode/ai/effect"
import type { SessionMessage } from "../session/message"

export function copyWith<T extends object>(value: T, changes: Partial<T>): T {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, replacement] of Object.entries(changes)) {
    const before = Object.getOwnPropertyDescriptor(value, key)
    Object.defineProperty(descriptors, key, { enumerable: true, configurable: true, value: {
      value: replacement, enumerable: before?.enumerable ?? true,
      configurable: before?.configurable ?? true, writable: before && "writable" in before ? before.writable : true,
    } })
  }
  return Object.create(Object.getPrototypeOf(value), descriptors)
}

export function canonicalMessages(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return []
  return messages.filter((message) => message && typeof message === "object").map((message) => {
    const content = (Array.isArray(message.content) ? message.content : []).filter(Boolean).map((part) =>
      part.type === "tool-result" && part.result?.type === "content" && !Array.isArray(part.result.value)
        ? copyWith(part, { result: copyWith(part.result, { value: [] }) }) : part)
    return Array.isArray(message.content) && content.length === message.content.length && content.every((part, i) => part === message.content[i])
      ? message : copyWith(message, { content })
  })
}

export function historyMessages(messages: readonly SessionMessage.Info[]): SessionMessage.Info[] {
  return messages.map((message) => {
    const content = (Array.isArray(message.content) ? message.content : []).filter(Boolean).map((part) =>
      part.type === "tool" && part.state?.status === "completed" && !Array.isArray(part.state.content)
        ? copyWith(part, { state: copyWith(part.state, { content: [] }) }) : part)
    return Array.isArray(message.content) && content.length === message.content.length && content.every((part, i) => part === message.content[i])
      ? message : copyWith(message, { content })
  })
}
