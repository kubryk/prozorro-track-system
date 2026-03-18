import { defineConfig } from 'vite'

const allowedHosts = ['.trycloudflare.com']

export default defineConfig({
  server: {
    allowedHosts,
  },
  preview: {
    allowedHosts,
  },
})
