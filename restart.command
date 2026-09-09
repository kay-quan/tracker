#!/bin/bash
# Double-click this if the tracker is misbehaving.
# It stops anything left running, then starts one clean copy.
cd "$(dirname "$0")" || exit 1

echo ""
echo "  Stopping anything already running..."
pkill -f "income-tracker/server.py" 2>/dev/null
pkill -f "server.py" 2>/dev/null
sleep 1

echo "  Starting a fresh copy..."
echo ""
exec /usr/bin/python3 server.py
