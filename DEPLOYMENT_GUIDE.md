# Render.com Deployment Guide

## Prerequisites
- GitHub account (free)
- Render.com account (free)

## Step-by-Step Deployment

### Step 1: Push Your Code to GitHub

1. **Create a GitHub account** (if you don't have one):
   - Go to https://github.com/signup
   - Sign up for free

2. **Create a new repository**:
   - Go to https://github.com/new
   - Name it: `church-management-system`
   - Make it **Private** (recommended for church data)
   - Click "Create repository"

3. **Push your code** (run these commands in your terminal):

```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - Church Management System"

# Add your GitHub repository
git remote add origin https://github.com/YOUR_USERNAME/church-management-system.git

# Push to GitHub
git branch -M main
git push -u origin main
```

### Step 2: Deploy to Render

1. **Create Render account**:
   - Go to https://render.com
   - Click "Get Started for Free"
   - Sign up with your GitHub account (easiest)

2. **Create a new Web Service**:
   - Click "New +" button
   - Select "Web Service"
   - Connect your GitHub account (if not already)
   - Select your `church-management-system` repository

3. **Configure the service**:
   - **Name**: `church-management-system` (or any name you prefer)
   - **Region**: Choose closest to your location
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` (for now)

4. **Add Environment Variables**:
   - Click "Advanced"
   - Add these environment variables:
     - `NODE_ENV` = `production`
     - `JWT_SECRET` = (click "Generate" to create a secure random key)
     - `PORT` = `3000`

5. **Deploy**:
   - Click "Create Web Service"
   - Wait 2-5 minutes for deployment
   - You'll get a URL like: `https://church-management-system-xxxx.onrender.com`

### Step 3: Test Your Deployed App

1. Open the URL Render gives you
2. You should see the login page
3. Login with: `admin` / `admin123`
4. Test creating branches and pastors

### Step 4: Share with Users

1. **Share the URL** with your pastors
2. **Tell them to**:
   - Open the link on their phone
   - Tap "Install" when prompted
   - Add to home screen

## Important Notes

### Free Tier Limitations
- ✅ Perfect for 200 users
- ✅ Unlimited bandwidth
- ⚠️ Sleeps after 15 minutes of inactivity (wakes up in ~30 seconds)
- ⚠️ 750 hours/month free (enough for testing)

### Upgrade to Paid ($7/month) When Ready
- No sleep/downtime
- Always fast
- Better for production use

### Database Persistence
- SQLite database is stored on Render's disk
- **Important**: Free tier may lose data on redeploy
- For production, consider upgrading or using PostgreSQL

### Security Recommendations
1. **Change default admin password** immediately after deployment
2. **Use HTTPS** (Render provides this automatically)
3. **Keep your GitHub repo private**
4. **Don't share your JWT_SECRET**

## Updating Your App

When you make changes:

```bash
# Make your changes
# Then commit and push
git add .
git commit -m "Description of changes"
git push

# Render will automatically redeploy!
```

## Custom Domain (Optional)

If you want your own domain like `church.yourchurch.com`:

1. Buy a domain (Namecheap, GoDaddy, etc.)
2. In Render dashboard, go to Settings → Custom Domain
3. Add your domain and follow DNS instructions
4. Free SSL certificate included!

## Troubleshooting

**App won't start?**
- Check Render logs in the dashboard
- Make sure all environment variables are set

**Database resets?**
- Free tier may reset on redeploy
- Upgrade to paid tier for persistence
- Or migrate to PostgreSQL (I can help with this)

**App is slow?**
- Free tier sleeps after inactivity
- First request wakes it up (~30 seconds)
- Upgrade to paid tier for always-on

## Need Help?

If you run into issues:
1. Check Render logs (in dashboard)
2. Check browser console (F12)
3. Ask me for help!

---

**Your app will be live at**: `https://your-app-name.onrender.com`

**Total cost**: $0 (free tier) or $7/month (paid tier for production)
