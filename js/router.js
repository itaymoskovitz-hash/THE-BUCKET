// Hash router: #/path. Hash routes never reach the server, so invitation tokens in the URL stay out of server logs.
const handlers = new Set();
export const currentPath = () => (location.hash.replace(/^#/, '') || '/');
export function navigate(path, { replace = false } = {}) {
  const url = '#' + path;
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  handlers.forEach((fn) => fn(currentPath()));
}
export function onRoute(fn) {
  handlers.add(fn);
  window.addEventListener('hashchange', () => fn(currentPath())); // back/forward + typed links
}
