import { createComponent, mergeProps } from "solid-js"
import { wake } from "./lifetime-state"

export function decorate(stock: typeof import("../context/client")) {
  const ClientProvider: typeof stock.ClientProvider = (props) => {
    const service = props.service
    if (!service) return createComponent(stock.ClientProvider, props)
    return createComponent(stock.ClientProvider, mergeProps(props, {
      service: {
        ...service,
        async reconnect(signal: AbortSignal) {
          await wake.wait(signal)
          return service.reconnect(signal)
        },
      },
    }))
  }
  return { ClientProvider }
}
