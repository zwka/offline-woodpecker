# Browser-first offline applications

The Generator and Trainer are delivered as local-first React applications that run in Chrome on desktop and as Android Chrome PWAs. This keeps the two applications on one shared TypeScript model and avoids a native shell. A local bundle or local server serves the apps, while a Cloudflare Quick Tunnel may provide the HTTPS origin required to install them on Android. The tunnel transports browser traffic to the local preview server; the applications have no remote API dependency.
