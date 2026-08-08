import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // VITE_PROXY_TARGET can come from the shell env or from client/.env.local
  // (untracked). Default preserves the original behavior: proxy to prod.
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_PROXY_TARGET || 'https://mineblock-dashboard.onrender.com';
  console.log('[vite] API proxy target:', target);

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          secure: !env.VITE_PROXY_TARGET,
          cookieDomainRewrite: { '*': '' },
          configure: (proxy) => {
            // Strip Secure and SameSite flags from cookies so they work on http://localhost
            proxy.on('proxyRes', (proxyRes) => {
              const setCookie = proxyRes.headers['set-cookie'];
              if (setCookie) {
                proxyRes.headers['set-cookie'] = setCookie.map((cookie) =>
                  cookie
                    .replace(/;\s*Secure/gi, '')
                    .replace(/;\s*SameSite=\w+/gi, '; SameSite=Lax')
                );
              }
            });
          },
        },
      },
    },
  };
})
