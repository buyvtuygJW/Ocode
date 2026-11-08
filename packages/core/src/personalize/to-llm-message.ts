import { Message } from "@opencode/ai/effect"
import { decay, indexBlock } from "../session/runner/context-decay"
import { historyMessages } from "./content"

export function decorate(stock: typeof import("../session/runner/to-llm-message")) {
  const toLLMMessages: typeof stock.toLLMMessages = (messages, ...rest) => {
    const decayed = decay(historyMessages(messages))
    const lowered = stock.toLLMMessages(decayed.messages, ...rest)
    const index = indexBlock(decayed.archive)
    return index === undefined ? lowered : [...lowered, Message.user(index)]
  }
  return { toLLMMessages }
}
