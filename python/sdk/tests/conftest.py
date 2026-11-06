"""Isolate SDK test subprocesses from the machine's memory daemon.

Port zero cannot name a listening TCP service. Tests with an owned endpoint
can override this default with pytest's monkeypatch fixture.
"""
import os

os.environ['HINDSIGHT_API_URL'] = 'http://127.0.0.1:0'
