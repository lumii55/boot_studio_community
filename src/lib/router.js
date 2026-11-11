// Minimal method + path router. Patterns use ":name" segments.

export class Router {
  constructor() {
    this.routes = [];
  }

  on(method, pattern, handler) {
    const names = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          names.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${source}$`), names, handler });
    return this;
  }

  // Returns {handler, params} or {status: 404|405}.
  match(method, path) {
    let pathMatched = false;
    for (const route of this.routes) {
      const found = route.regex.exec(path);
      if (!found) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(found[index + 1]);
      });
      return { handler: route.handler, params };
    }
    return { status: pathMatched ? 405 : 404 };
  }
}
