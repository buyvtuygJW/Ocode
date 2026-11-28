export function decorate(stock: typeof import("../logo")) {
  return { logo: { ...stock.logo, left: [" █▀▀▀▀▀▀█ ", " ▀█    █▀ ", "  ▀█__█▀  ", "█▄▄█  █▄▄█"] } }
}
