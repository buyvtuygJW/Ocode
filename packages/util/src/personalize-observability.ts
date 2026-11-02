export function decorate(stock: typeof import("./observability")) {
  const layer: typeof stock.layer = (options = {}) => stock.layer({ ...options, endpoint: undefined, headers: undefined })
  return { layer }
}
