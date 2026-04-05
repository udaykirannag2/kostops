import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import App from './App';
import './index.css';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId:       import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
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
