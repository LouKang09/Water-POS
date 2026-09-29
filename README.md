# Water POS

Mobile-first point-of-sale web application for a water refilling business, with a desktop/tablet admin dashboard.

## POS
- Top categories: Delivery, Pick-Up, New, Used
- Delivery: ₱25 / ₱35 / ₱45
- Pick-Up: ₱20 / ₱30 / ₱40
- New: ₱200 per gallon
- Used: admin-configurable price buttons
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
