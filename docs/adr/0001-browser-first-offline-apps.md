# Browser-first offline applications

The Generator and Trainer are delivered as local-first React applications that run in Chrome on desktop and Android Chrome for the Trainer. This keeps the two applications on one shared TypeScript model and avoids a native shell. A local bundle or local server serves the apps, while a Cloudflare Quick Tunnel may provide the HTTPS origin required to install the Trainer on Android. The tunnel transports browser traffic to the local preview server; the application has no remote API dependency.
