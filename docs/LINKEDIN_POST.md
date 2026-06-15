# LinkedIn Post

---

**🚨 A Security Header Broke My Entire Application — And No Errors Were Thrown**

Just deployed a Node.js app to AWS ECS behind an Application Load Balancer. Everything looked fine — health checks passing, container running, HTML loading.

But the app was completely broken. No styles. No JavaScript. Login failing silently.

Here's what happened:

I had Helmet.js configured with production-grade security headers. Two of them silently destroyed the user experience:

```
Strict-Transport-Security: max-age=15552000
Content-Security-Policy: ...upgrade-insecure-requests
```

These headers told the browser: "Upgrade every request to HTTPS."

The problem? My ALB only had an HTTP listener. No SSL certificate yet.

So the browser loaded the HTML over HTTP, then tried to fetch CSS, JS, and API calls over HTTPS. All failed silently. No error in the server logs. No 4xx. No 5xx. Just... nothing loaded.

**The debugging process:**

```bash
# Server returning CSS? Yes.
curl -sI http://my-alb-url/styles.css → 200 OK ✅

# But the browser never received it.
# Because it was requesting https://my-alb-url/styles.css → Connection refused
```

`curl` doesn't respect HSTS or CSP. Browsers do. That's why the server looked healthy but users saw a broken page.

**The fix:**

Gate HTTPS enforcement behind an environment variable:
```javascript
strictTransportSecurity: process.env.ENABLE_HTTPS === 'true' ? {...} : false
upgradeInsecureRequests: process.env.ENABLE_HTTPS === 'true' ? [] : null
```

**Lessons for DevOps engineers:**

1. Security headers are infrastructure — they must match your actual transport config
2. Always test with a real browser, not just `curl` — they behave differently
3. HSTS is cached by the browser for the declared max-age. One wrong deployment can lock users out for months
4. Your app can return 200 on every endpoint and still be completely broken from the user's perspective
5. When debugging "works in curl, broken in browser" — check response headers first

This is the kind of issue that doesn't show up in staging when both environments use HTTPS. It only appears when your dev/test environment uses HTTP. Environment parity matters.

---

#DevOps #AWS #ECS #Troubleshooting #Security #WebDevelopment #Helmet #NodeJS #Infrastructure
