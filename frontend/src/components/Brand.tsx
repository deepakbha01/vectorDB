import { useEffect } from 'react';
import { Link } from 'react-router-dom';

/** The product name, shown on every page and in the browser tab. */
export const APP_NAME = 'Evectorize';

/** The tagline shown with the name: under it on the sign-in pages, beside it in the top bar. */
export const APP_TAGLINE = 'Where Data Finds Direction';

/** Sets the browser tab title to "<page> · Evectorize". */
export function usePageTitle(page: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}

/**
 * The Evectorize wordmark with its tagline; the name links to the dashboard where there is one
 * to go to. Large (sign-in pages): the tagline sits under the name. Otherwise (top bar): beside it.
 */
export function BrandMark({ linked = true, large = false }: { linked?: boolean; large?: boolean }) {
  const className = large ? 'brand-mark brand-mark-large' : 'brand-mark';
  const name = linked ? (
    <Link to="/dashboard" className={className} aria-label={`${APP_NAME} - dashboard`}>
      {APP_NAME}
    </Link>
  ) : (
    <span className={className}>{APP_NAME}</span>
  );
  return (
    <div className={large ? 'brand brand-large' : 'brand'}>
      {name}
      <span className="brand-tagline">{APP_TAGLINE}</span>
    </div>
  );
}

/**
 * A large, faint Evectorize across the page. Decorative only: hidden from screen
 * readers, never catches clicks, and too faint to get in the way of reading.
 */
export function Watermark() {
  return (
    <div className="watermark" aria-hidden="true">
      {APP_NAME}
    </div>
  );
}
