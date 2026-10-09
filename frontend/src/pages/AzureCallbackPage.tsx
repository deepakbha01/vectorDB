import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { completeAzureSignIn } from '../api/azureAuth';

/** Where Microsoft sign-in returns (the SPA redirect URI on the app registration); finishes the sign-in and goes back to the page that started it. */
export function AzureCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // React's development double-run would process the one-time code twice.
    if (started.current) return;
    started.current = true;
    completeAzureSignIn()
      .then((returnTo) => navigate(returnTo, { replace: true }))
      .catch((err) => setError(err instanceof Error ? err.message : 'The Azure sign-in did not complete.'));
  }, [navigate]);

  return (
    <div className="main-content">
      {error ? (
        <div className="card">
          <div className="error-text">Azure sign-in failed: {error}</div>
          <Link to="/dashboard">Back to the dashboard</Link>
        </div>
      ) : (
        <div className="card">Completing the Azure sign-in...</div>
      )}
    </div>
  );
}
