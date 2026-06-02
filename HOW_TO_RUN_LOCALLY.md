# How to Run the App on Your Computer

## What You Need First

Install these two things before anything else:

1. **Node.js** - Download from https://nodejs.org
   - Click the big green "LTS" button to download
   - Install it like any normal app (Next → Next → Finish)
   - To verify it installed, open Terminal and type: `node --version`
   - You should see something like: `v20.11.0`

2. **A Terminal** - Already on your computer:
   - **Mac**: Press `Command + Space`, type "Terminal", press Enter
   - **Windows**: Press `Windows + R`, type "cmd", press Enter

---

## Running the App (Every Time)

### Step 1 - Open Terminal in the Project Folder

**On Mac:**
- Open Terminal
- Type `cd ` (with a space after cd)
- Drag the `church-idea` folder into the Terminal window
- Press Enter

**On Windows:**
- Open the `church-idea` folder in File Explorer
- Click the address bar at the top
- Type `cmd` and press Enter
- A terminal opens already in the right folder

### Step 2 - Install Dependencies (First Time Only)

Type this and press Enter:
```
npm install
```
Wait for it to finish. You'll see a lot of text scrolling — that's normal.
You only need to do this **once**.

### Step 3 - Start the App

Type this and press Enter:
```
npm start
```

You should see:
```
Server running on port 3000
Default admin login: username: admin, password: admin123
```

### Step 4 - Open in Browser

Open any browser (Chrome, Safari, Firefox) and go to:
```
http://localhost:3000
```

The app will load and you can log in!

---

## Login Details

| Role | Username | Password |
|------|----------|----------|
| Main Leader | `admin` | `admin123` |
| Branch Pastor | (whatever you created) | (whatever you set) |

---

## Stopping the App

When you're done, go back to the Terminal and press:
```
Ctrl + C
```
This stops the server. Your data is saved and will be there next time.

---

## Quick Summary

Every time you want to use the app:
1. Open Terminal
2. Navigate to the project folder
3. Type `npm start`
4. Open `http://localhost:3000` in your browser
5. Press `Ctrl + C` when done

---

## Troubleshooting

**"npm is not recognized" or "command not found"**
- Node.js is not installed. Go to https://nodejs.org and install it.

**"Port 3000 already in use"**
- The app is already running. Just open `http://localhost:3000` in your browser.
- Or close the other terminal that's running it.

**Page won't load**
- Make sure you ran `npm start` and see the "Server running" message.
- Make sure you're going to `http://localhost:3000` not `https://`.

**Lost your data**
- Data is stored in a file called `church.db` in the project folder.
- As long as that file exists, your data is safe.
- Never delete that file.

---

## Sharing With Others on the Same WiFi (Optional)

If a pastor is on the **same WiFi network** as your computer and wants to test:

1. Find your computer's IP address:
   - **Mac**: Go to System Preferences → Network → your IP looks like `192.168.x.x`
   - **Windows**: Open cmd, type `ipconfig`, look for "IPv4 Address"

2. Share this URL with them:
   ```
   http://192.168.x.x:3000
   ```
   (Replace `192.168.x.x` with your actual IP)

3. They can open it on their phone browser and even install it as an app!

> **Note**: This only works on the same WiFi. For access outside your home/office, you need to deploy (see QUICK_DEPLOY.md).
