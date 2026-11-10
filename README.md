# The Baithak Stories – orders, kitchen screen, billing, daily stats

The front page has four doors:

| Door | Opens | Who | Language |
|---|---|---|---|
| Waiter (/waiter) | order entry on the waiter's phone | waiter PIN | Hindi |
| Kitchen (/kitchen) | the cooks' screen: new orders ring a bell, one tap marks them ready | kitchen PIN | Hindi |
| Admin (/counter and /owner) | counter (bills, printing) or the owner dashboard, depending on the PIN | counter PIN or owner PIN | English |
| Customer (/menu) | the menu, no login | anyone | Hindi or English |

A PIN only works at its own door. A PIN typed at the wrong door is refused, and counts as a wrong try (8 wrong tries lock that device for 10 minutes).
Someone who is already signed in goes straight to their own screen. After logging out you land on the front page again.

## Run it on your Windows PC (to try it out)

1. Install Node.js LTS from https://nodejs.org (accept the defaults).
2. Open the `baithak-pos` folder in File Explorer, click the address bar, type `powershell`, press Enter.
3. Run:

       npm install
       $env:WAITER_PIN="1234"; $env:COUNTER_PIN="2345"; $env:OWNER_PIN="9876"
       npm start

4. Open http://localhost:3000 in Chrome and log in with one of the PINs.
5. To try it from your phone on the same Wi-Fi: run `ipconfig`, note the "IPv4 Address" (e.g. 192.168.1.20),
   open http://192.168.1.20:3000 on the phone. If Windows Firewall asks, allow access on private networks.

Stop the server with Ctrl+C. Data is kept in the `data` folder.

## Printing with your Seznik Bluetooth printer (one printer for tickets and bills)

The counter page prints straight to the printer from Chrome or Edge on the counter laptop. Hindi prints correctly because
each ticket is sent as a picture.

1. Charge the printer fully, load the paper and switch it on (the BT light should show).
2. On the counter laptop, open the app in Chrome and log in with the counter PIN.
3. Click **Printer: not connected** at the top > **Connect Bluetooth printer**. Pick the Seznik in Chrome's list.
   Do not pair it in Windows Settings first for this option.
4. Click the printer button again > **Test print**. A test ticket with Hindi should come out.
5. If your paper is 80 mm wide (not 58 mm), click the printer button > **Paper: 80 mm**.

If the printer is not in Chrome's list, or the test prints nothing:
- Pair it in Windows first (Settings > Bluetooth & devices > Add device > Bluetooth), then use
  **Connect via COM port / USB** in the printer menu.
- The sticker on the printer says: if the Error light blinks twice ("wrong mode"), press the power button 3 times.
- Keep the laptop within a few metres of the printer.

After a restart, press the printer button and connect again (Chrome asks once per session for Bluetooth).
If no printer is connected, the app falls back to the normal Windows print dialog.

The printer is only used for **bills**. Kitchen orders do not print: the cooks read them on the kitchen screen.

## How an order moves

1. The waiter picks a table, adds items and taps **किचन भेजें**. He can also write down orders for several tables first (they stay as drafts, shown by a number on the table) and send them all with **सब किचन भेजें**.
2. The order appears at once on the **kitchen screen** (a bell rings) and on the **counter** list.
3. The cook taps **तैयार** when the food is ready. The waiter's phone shows "खाना तैयार है" until he taps **परोस दिया**.
4. To add items to a table that is already eating, the waiter taps that table (or the **+ टेबल N में और जोड़ें** button on top), picks items and sends. The kitchen sees it as a new ticket marked "और आइटम जुड़े".
5. The counter can print the bill or take payment for any open order at any time. The waiter does not have to ask for it.

## Payment checks (Cash / UPI / Card)

1. **Print bill** gives the bill its number and locks the amount. There are no more "estimate" slips.
2. After a bill is printed, the counter must tick **Cash, UPI, Card or Cash + online** for it. For Cash + online the counter types how much was cash and the rest is counted as online (UPI), so the dashboard's Cash and UPI totals each get their share. A yellow box at the top of the counter page lists every bill still waiting for a tick.
3. **The next bill will not print** until the last one is ticked. The counter gets a small box asking how the guest paid, and printing carries on after the tick. (Reprinting the same bill is always allowed.)
4. When the counter ticks a table, the waiter's phone asks **"ग्राहक ने कैसे पैसे दिए?"** with नक़द / UPI / कार्ड / दोनों (नक़द + ऑनलाइन). There is no "did not see" button, so the waiter has to answer for every table. He is never shown what the counter chose, so he answers from what he saw. He is not asked for amounts, only which way the guest paid.
5. If the two answers differ, the owner sees it under **Payment checks** on the dashboard and picks one: "Counter was right" or "Waiter was right: change to ...". Changing to Cash + online asks the owner for the cash amount. The change is logged, and the day's Cash / UPI / Card totals update.
6. Parcels are not part of the waiter check (the waiter usually does not see parcel payments). Tables the waiter has not answered show as "not yet confirmed" on the owner dashboard.
7. The discount is the owner's and is set when the bill is printed. It is locked after that. If items are added after printing, the order shows "items changed, print again".
8. If an order whose bill was printed is cancelled (for example the guest left), it stops blocking the next bill.

This does not stop two people agreeing to lie, so keep doing the nightly cash count: compare "Cash in hand" on the dashboard with the drawer, and UPI with the HDFC alerts.

## The kitchen phone

- Open the app link on the kitchen phone, choose **रसोई** and enter the kitchen PIN, then tap **शुरू करें** once. Phones only allow sound after a tap, so this tap is needed every time the page is opened fresh.
- Turn the phone volume up and keep the screen on: the app asks the phone not to sleep, but the phone must stay unlocked with the app on screen. Put it on a charger.
- A new order rings a bell and vibrates. Until someone taps the ticket, it rings again every 30 seconds.
- A cancelled item rings a different, lower sound and shows a red "इन्हें न बनाएँ" card.
- If the sound button at the top is red ("आवाज़ बंद"), tap it to switch the sound back on.
- On iPhone, the silent switch also mutes the bell. Android phones are the safer choice for the kitchen.

## Put it online (Railway)

1. Put this folder in a GitHub repository (private is fine):

       git init
       git add .
       git commit -m "restaurant app"
       git branch -M main
       git remote add origin https://github.com/YOUR-NAME/baithak-pos.git
       git push -u origin main

2. In Railway: New Project > Deploy from GitHub repo > choose it.
3. In the service: add a **Volume** and mount it at `/data`. This is where the database lives; without it, data is lost on every deploy.
4. Variables tab, add:
   `DATA_DIR=/data`, `WAITER_PIN`, `COUNTER_PIN`, `KITCHEN_PIN`, `OWNER_PIN` (choose your own), and optionally `TABLES` (default 12).
5. Settings > Networking > Generate Domain. That link is your app. Open it on every phone and on the counter laptop.
6. Run only **one instance** of the service (the database is a single file).

## Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| WAITER_PIN / COUNTER_PIN / KITCHEN_PIN / OWNER_PIN | 1111 / 2222 / 3333 / 9999 | Change these before real use. Each must be different |
| TABLES | 12 | Number of tables shown to the waiter |
| TAX_PERCENT | 0 | GST % added on the bill. Ask your CA what applies before setting it |
| RESTAURANT_NAME, RESTAURANT_PHONE | Baithak Stories / your numbers | Printed on the bill |
| DATA_DIR | ./data | Where the database file is kept |
| GRACE_SEC | 120 | For this many seconds after sending, the waiter can delete an item instantly. After that the owner has to approve. Set 0 to always need approval |
| LOOK | nawabi | Default look for devices that have not picked one: nawabi, brand (Baithak green) or indigo |
| THEME | dark for nawabi, otherwise light | Default light or dark |
| PUBLIC_URL | the address you opened | Address printed into the table QR codes (set it to your live Railway address) |
| TZ_OFFSET_MIN | 330 | India time |

## How the control against skipped orders works

- The kitchen cooks only from the kitchen screen, so an order that isn't entered never reaches the kitchen.
- Removing an item or cancelling an order after it was sent: the waiter can do it instantly for the first 2 minutes (a mis-tap). After that it needs the owner's approval (Owner > Approvals). Every removal is logged, and a bill can't be closed while a request is pending.
- When an item is removed after it was sent, the kitchen screen shows a red cancel card and rings, so they stop cooking it.
- Kitchen tickets are numbered in sequence and every removal, discount and who took the order is logged.
- Every night: compare "Cash" on the dashboard with the cash in the drawer, and "UPI" with the HDFC account alerts.

## Backups

Download the CSV from the Owner page (Export orders) every week and keep it in Google Drive.

## Phone tips for the waiter

- Open the app link in Chrome, then use the menu > "Add to Home screen" to get an icon that opens it full screen.
- If the internet drops while he sends an order, the order is saved on the phone and goes to the kitchen by itself when the connection returns.
- The moon icon at the top switches between light and dark.

## Menu and Hindi names

The menu was copied from the website. The Hindi names are a first draft: fix any of them in Owner > Menu. Changes save by themselves.

## Logo on the printed bill

Bills print with one faint dotted logo centred behind the text. A thermal printer only prints black dots,
so the "transparency" is a sparse dot pattern. Change the strength from the printer button on the counter page: Logo on bills > Off / Light / Medium / Strong (Light is the default).
"Print a sample bill" in the same menu prints a test bill so you can pick the one you like on real paper.

## Customer menu and table QR codes

Customers open the Customer door (or scan a QR code) and see the full menu in Hindi or English, with half/full prices and "not available today" for anything you switched off in Owner > Menu. No login, and customers cannot place orders: the menu tells them to call the waiter.

QR codes: in the Owner dashboard click "Table QR codes". It opens a printable sheet with one code per table plus one general menu code. Each table code opens the menu with that table number shown at the top.
Open this page from your live Railway address (or set PUBLIC_URL), otherwise the codes will point to your own computer and will not work for customers.
