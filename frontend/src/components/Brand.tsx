import { useEffect } from 'react';
import { Link } from 'react-router-dom';

/** The product name, shown on every page and in the browser tab. */
export const APP_NAME = 'Evectorize';

/** Sets the browser tab title to "<page> · Evectorize". */
export function usePageTitle(page: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}

/** The Evectorize wordmark; links to the dashboard where there is one to go to. */
export function BrandMark({ linked = true, large = false }: { linked?: boolean; large?: boolean }) {
  const className = large ? 'brand-mark brand-mark-large' : 'brand-mark';
  return linked ? (
    <Link to="/dashboard" className={className} aria-label={`${APP_NAME} - dashboard`}>
      {APP_NAME}
    </Link>
  ) : (
    <span className={className}>{APP_NAME}</span>
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
