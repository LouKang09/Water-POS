# Water POS

Mobile-first point-of-sale web application for a water refilling business, with a desktop/tablet admin dashboard.

## POS
- Top categories: Delivery, Pick-Up, New, Used, Retail, Unpaid
- Delivery: ₱25 / ₱35 / ₱45
- Pick-Up: ₱20 / ₱30 / ₱40
- New: ₱200 per gallon
- Used: admin-configurable price buttons
- Retail: ₱9 Reseller and ₱15 Retail direct to consumer (selectable quantity)
- Multiple quantities and mixed items in one transaction
- Cash and GCash payment
- Automatic Water POS transaction reference
- GCash receipt image OCR in the browser, editable detected reference, and receipt image storage for admin cross-checking

## Admin
- Desktop/tablet-only admin route: /admin.html
- Sales totals, Cash, GCash, expenses, and net
- Transaction and item history
- GCash receipt image cross-check
- Add/delete expenses
- Configure Used price buttons

## Required environment variables
- DATABASE_URL: PostgreSQL connection URL
- JWT_SECRET: strong random signing secret
- ADMIN_EMAIL: admin login email
- ADMIN_PASSWORD: admin login password
- NODE_ENV=production on Railway

## Local development
1. Create a PostgreSQL database.
2. Set the environment variables above.
3. Run `npm install`.
4. Run `npm start`.
5. POS: http://localhost:3000
6. Admin: http://localhost:3000/admin.html

Database tables are created automatically on startup.

## Employee attendance and payroll (October 2026)

**POS app**: Signed-in employee accounts show a Time In / Time Out card. Time In is an explicit action; signing out, refreshing or switching apps does not time out a shift. Start Lunch pauses paid work time; End Lunch resumes. An attempted clock-out before 6:00 PM or before 8 paid work hours requires confirmation, and an early time-out can be resumed on the same day with **Continue Shift**. Reopened time-out gaps are excluded from paid time.

The app shows a live attendance timer and two in-app reminders: 45 minutes into lunch, and at 5:45 PM if the employee has not clocked out. Reminders run while the POS page remains active; they are **not guaranteed background push notifications** if an Android device suspends or closes the app.

**Admin > Payroll & Attendance**: Create employee accounts or select an existing POS employee. Set each employee's payroll name and daily wage (default ₱582). Cutoff periods are 1–15 and 16–last calendar day (February automatically uses 28 or 29). Review daily time records, lateness, lunch and unfinished shifts. An admin can close a missed shift with a mandatory reason; past-day default clock-out is 6 PM Philippine time and the time is adjustable if needed.

**Automatic draft payroll policy**:
- Scheduled shift 9:00 AM–6:00 PM, one-hour unpaid lunch, eight paid hours.
- Base completed day: employee-specific daily wage (default ₱582 ÷ 8 = ₱72.75/hour).
- Lateness from 9 AM through 9:29 AM carries no automatic lateness deduction; starting at 9:30 AM actual late minutes are deductible.
- Clock-outs before 6 PM, lunch over 60 minutes, and time-out gaps when a shift is resumed generate unpaid minutes.
- Automatic deductions for a single day cannot exceed that day's daily wage.
- Missing/unclosed shifts are excluded from calculated wages until completed or administratively resolved.
- Draft figures are for review. Overtime, statutory contributions, special holidays, leave, and other employment-law-specific payroll treatments are **not automated** in this release; add or adjust them in the editable payslip.

The editable payslip has employee name, pay period label, pay date (today in Philippine time by default), earnings and deduction rows, and net pay. **Save Payslip** allocates an incrementing payslip number starting at 46; editing the same employee/period keeps its existing number. The admin can change the next unused number. **Save & Print Payslip** renders an A4 two-column earnings/deductions format with signature lines.

## Android v1.3.0 — offline sales and normal navigation

Android v1.3.0 disables Huawei/Android kiosk screen pinning and uses `adjustResize` for the numeric keyboard. Camera/gallery switching works without re-entering LockTask. The app still connects to the existing Railway Water POS.

### Working without internet
1. Install v1.3.0 and sign in **online at least once**. Keep the Android app installed and allow the initial offline assets to cache.
2. A previously verified cashier can reopen the app without a network connection. The service worker caches the POS shell; IndexedDB stores the offline sale queue and receipt images.
3. Record ordinary new sales, including Cash, Pay Later, GCash, or Other with a photo receipt. Offline digital receipts can be marked unreadable for admin review. A sale is labeled **LOCAL / Pending Sync** until the database acknowledges it.
4. On reconnect, while Water POS is open or when it is reopened, pending sales automatically retry. The **Pending / Sync now** banner shows outstanding items and any transactions requiring attention.
5. Every queued sale receives a stable client key; PostgreSQL enforces uniqueness and serializes conflicting retries. This prevents duplicate sales if an upload succeeds but its response is lost. Original capture date/time is retained in the sales records.

**Limitations:** First-time authentication, existing unpaid settlements, online delivery queue completion, payroll attendance, and central reports require connectivity. Cached Used prices may be rejected during sync if an administrator changed them meanwhile; blocked sales remain on the device for review. Payment receipts and queued sales remain on the device until successfully synced; never uninstall or clear app data with pending sales. Android background sync after the app is fully closed is not guaranteed — open the app when back online. The existing offline mode is intended for the WebView-based Android app and supported browsers with IndexedDB and service-worker support.
