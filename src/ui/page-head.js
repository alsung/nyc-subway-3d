// src/ui/page-head.js
// Keeps the page's <head> in step with what the map shows (#155): the title,
// description, canonical URL and share-card tags of the open station or line,
// or the home page's when nothing is open.
//
// A pre-built station page arrives with its own head, and Google reads the head
// after the app has run, so the app has to set the same values the page was
// built with. They come from core/page-meta.js, which the build uses too.

import { SITE } from '../core/page-meta.js';

/**
 * @param {{title: string, description: string, ogDescription?: string, path: string}} head
 */
export function setPageHead({ title, description, ogDescription, path }) {
    const url = `${SITE}${path}`;
    document.title = title;
    setContent('meta[name="description"]', description);
    setContent('meta[property="og:title"]', title);
    setContent('meta[property="og:description"]', ogDescription ?? description);
    setContent('meta[property="og:url"]', url);

    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
    }
    canonical.href = url;
}

function setContent(selector, value) {
    document.head.querySelector(selector)?.setAttribute('content', value);
}
