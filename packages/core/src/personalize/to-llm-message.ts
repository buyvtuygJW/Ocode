import { Message } from "@opencode/ai/effect"
import { decay, indexBlock } from "../session/runner/context-decay"
import { historyMessages } from "./content"
import { bypassDecay } from "./decay-policy"

export function decorate(stock: typeof import("../session/runner/to-llm-message")) {
  const toLLMMessages: typeof stock.toLLMMessages = (messages, ...rest) => {
    const history = historyMessages(messages)
    if (bypassDecay()) return stock.toLLMMessages(history, ...rest)
    const decayed = decay(history)
    const lowered = stock.toLLMMessages(decayed.messages, ...rest)
    const index = indexBlock(decayed.archive)
    return index === undefined ? lowered : [...lowered, Message.user(index)]
  }
  return { toLLMMessages }
}
