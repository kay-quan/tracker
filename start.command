#!/bin/bash
# Double-click this file to start the Income Tracker.
cd "$(dirname "$0")" || exit 1
exec /usr/bin/python3 server.py
