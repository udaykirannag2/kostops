import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import App from './App';
import './index.css';
import { getRuntimeConfig } from './runtimeConfig';

/**
 * Bootstrap the app after resolving runtime config.
 *
 * Config priority (handled by getRuntimeConfig):
 *   1. /runtime-config.json  — deployed by CDK custom resource, always has real values
 *   2. VITE_* env vars       — only for local dev (copy .env.example → .env)
 */
async function bootstrap() {
  const config = await getRuntimeConfig();

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId:       config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Authenticator
        hideSignUp
        components={{
          Header() {
            return (
              <div className="flex flex-col items-center pt-8 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-2xl font-bold text-brand-700 tracking-tight">KostOps</span>
                </div>
                <p className="text-sm text-gray-500">AWS cost visibility &amp; optimization</p>
              </div>
            );
          },
        }}
      >
        {({ signOut, user }) => <App signOut={signOut} user={user} />}
      </Authenticator>
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  console.error('KostOps failed to start:', err);
  document.getElementById('root')!.innerHTML =
    `<div style="padding:2rem;font-family:sans-serif;color:#c00">
      <h2>Configuration error</h2>
      <p>${err?.message ?? err}</p>
      <p style="color:#666;font-size:.9rem">
        Hosted app: redeploy KostOpsFrontendStack.<br>
        Local dev: copy <code>.env.example</code> to <code>.env</code> and set VITE_* vars.
      </p>
    </div>`;
});
