# Church Management System - PWA Installation Guide

Your church management system is now a **Progressive Web App (PWA)**! This means users can install it on their phones and use it like a native app.

## What's New?

✅ **Installable** - Add to home screen like a native app
✅ **Full Screen** - No browser bars when opened
✅ **App Icon** - Beautiful icon on phone home screen
✅ **Offline Ready** - Basic caching for better performance
✅ **Fast Loading** - Cached resources load instantly

## How to Install on Different Devices

### iPhone/iPad (iOS/Safari)
1. Open Safari and go to your app URL
2. Tap the **Share** button (square with arrow)
3. Scroll down and tap **"Add to Home Screen"**
4. Name it "Church CMS" (or whatever you prefer)
5. Tap **"Add"**
6. The app icon will appear on your home screen!

### Android (Chrome)
1. Open Chrome and go to your app URL
2. You'll see a banner saying **"Install app"** - tap it
   - OR tap the **menu (⋮)** and select **"Install app"** or **"Add to Home Screen"**
3. Tap **"Install"**
4. The app icon will appear on your home screen!

### Desktop (Chrome/Edge)
1. Open Chrome/Edge and go to your app URL
2. Look for the **install icon** (⊕) in the address bar
3. Click it and select **"Install"**
4. The app will open in its own window!

## Features After Installation

- **Standalone Mode**: Opens in full screen without browser UI
- **Fast Launch**: Tap the icon and it opens instantly
- **Looks Native**: Feels like a real mobile app
- **Always Updated**: Automatically gets updates when you refresh

## For Church Leaders

When sharing the app with pastors:
1. Send them the URL
2. Tell them to "Add to Home Screen" (instructions above)
3. They can use it just like WhatsApp or any other app!

## Technical Notes

- **No App Store Required**: Users install directly from the browser
- **No Download Size**: It's just a web app, very lightweight
- **Instant Updates**: Changes you make are live immediately
- **Works Offline**: Basic functionality cached for offline use
- **Cross-Platform**: Works on iOS, Android, and Desktop

## Deployment Checklist

When deploying to production:
1. ✅ Use HTTPS (required for PWA)
2. ✅ Update `manifest.json` with your domain
3. ✅ Test installation on both iOS and Android
4. ✅ Customize app icons if needed
5. ✅ Update theme colors to match your church branding

## Customization

To change the app name or colors:
- Edit `public/manifest.json`
- Update `theme_color` and `background_color`
- Replace icon files in `public/` folder

---

**Your app is now ready to be installed like a native mobile app! 🎉**
