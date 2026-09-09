#!/usr/bin/env python3
"""
Serves the Income Tracker's files.

Your records no longer live here — they're in Firestore, reached straight from
the browser. This is now only a static file server, which is why it can safely
be opened to your own network so a phone can load the app.

Run it with:   ./start.command      (or:  python3 server.py)
"""

import http.server
import os
import socket
import socketserver
import threading
import webbrowser
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
# The app is served from the repo ROOT, matching GitHub Pages. It used to live in
# public/ locally while Pages served the root, and that mismatch meant three uploads
# in a row appeared to do nothing while the live site stayed on an old build.
# One layout, both places.
PUBLIC_DIR = HERE
PORT = 8420
PORT_TRIES = 12


def lan_ip():
    """This machine's address on the local network, for loading on a phone."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))       # no packets sent; just picks the route
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # Always revalidate, so an update can't half-apply from a stale cache.
        path = self.path.split("?")[0]
        if path.endswith((".html", ".js", ".css", "/")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self):
        # Single-page app: unknown paths fall back to the shell.
        path = urlparse(self.path).path
        target = os.path.join(PUBLIC_DIR, path.lstrip("/").split("?")[0])
        if path != "/" and not os.path.exists(target):
            self.path = "/"
        super().do_GET()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def already_running(port):
    """Is our own tracker already on this port?"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def main():
    os.chdir(HERE)

    httpd = None
    port = PORT
    for offset in range(PORT_TRIES):
        port = PORT + offset
        try:
            # 0.0.0.0 accepts connections from other devices on your network,
            # which is what lets the phone reach it. Only the app's files are
            # served — every record lives in Firestore behind your login.
            httpd = Server(("0.0.0.0", port), Handler)
            break
        except OSError:
            if already_running(port):
                url = "http://localhost:%d" % port
                print("\n  The Income Tracker is already running.")
                print("  Opening %s\n" % url)
                webbrowser.open(url)
                return
            continue

    if httpd is None:
        print("\n  Could not find a free port between %d and %d.\n" % (PORT, PORT + PORT_TRIES - 1))
        return

    ip = lan_ip()
    print("")
    print("  Income Tracker is running.")
    print("")
    print("    On this Mac:  http://localhost:%d" % port)
    if ip:
        print("    On your phone: http://%s:%d" % (ip, port))
        print("                   (same Wi-Fi, and leave this window open)")
    print("")
    print("  Press Control-C here to stop.")
    print("")

    threading.Timer(0.8, lambda: webbrowser.open("http://localhost:%d" % port)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
        httpd.shutdown()


if __name__ == "__main__":
    main()
