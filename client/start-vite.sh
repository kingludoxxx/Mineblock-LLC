#!/bin/bash
cd /Users/ludo/Mineblock-LLC/client
export PATH="/usr/local/bin:$PATH"
exec node node_modules/vite/bin/vite.js --host --port 5173
