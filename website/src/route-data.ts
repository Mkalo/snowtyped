import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { prefixHeroLinks } from './site';

export const onRequest = defineRouteMiddleware(({ locals }) => {
  prefixHeroLinks(import.meta.env.BASE_URL, locals.starlightRoute.entry.data);
});
