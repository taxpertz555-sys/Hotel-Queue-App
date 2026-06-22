# Restaurant Queue App

A small working prototype for restaurant walk-in queues.

## Run

```powershell
node server.js
```

Open the local URL shown in the terminal, usually:

```text
http://localhost:3030
```

For real phones on the same Wi-Fi, use the `Network:` URL printed by the server. The QR code in the owner desk is generated locally and points customers to the customer form.

If the page opens on your laptop but not your phone, use the `Network:` URL instead of `localhost`. The phone and laptop also need to be on the same Wi-Fi network, and Windows firewall may need to allow `node.exe` on port `3030`.

## Trustable mode

This app can serve HTTPS with a locally generated certificate chain.

```powershell
npm run trust
npm start
```

Then open the `Network:` HTTPS URL on the laptop and install `certs/ca.cer` on the phone once. After that, Chrome should trust the local site instead of warning that it is not safe.

## Deploy on Render

1. Put this folder on GitHub.
2. In Render, choose **New +** then **Blueprint**.
3. Connect your GitHub account and select this repository.
4. Render will read `render.yaml` automatically.
5. Click **Apply** and wait for the deploy to finish.
6. Open the Render URL it gives you. The QR on the owner screen will point to that public URL automatically.

Render serves the app over HTTPS for the public URL, so customers can open it safely on their phones.

## What it does

- Customer scans the QR code and fills the form.
- Customer receives a token number, position in queue, and estimated waiting time.
- Customer is warned to keep the page open so browser sound, vibration, and notifications can work.
- Owner desk shows a live queue.
- Owner can ring a customer or mark them seated.
- The customer page rings, vibrates, and shows a table-ready message when called.

This prototype stores queue data in server memory. Restarting the server clears the queue.
