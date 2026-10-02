"""Command-line helper: list users or reset a password in users.json.

  python reset_password.py --list
  python reset_password.py developer                 (asks for the new password)
  python reset_password.py developer "NewPass123"    (password on the command line)

Passwords can never be shown - only hashes are stored - so this SETS a new one.
Run it from the project folder (next to auth.py). Works even if the app is stopped.
"""
import getpass
import sys

import auth


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        return print(__doc__)
    if args[0] == "--list":
        users = auth.list_users()
        if not users:
            return print("No users yet. Start the app once (python app.py) to create the developer account.")
        print(f"{'USERNAME':<20}{'ROLE':<12}{'BUSINESS':<10}ACTIVE")
        for u in users:
            print(f"{u['username']:<20}{u['role']:<12}{u['business'] or '-':<10}{'yes' if u['active'] else 'NO'}")
        return print(f"\nFile: {auth.USERS_FILE}")

    username = args[0].strip().lower()
    password = args[1] if len(args) > 1 else getpass.getpass("New password: ")
    problem = auth._validate_password(password, username)
    if problem:
        return print("Error:", problem)
    with auth._lock:
        data = auth._read()
        rec = data["users"].get(username)
        if not rec:
            return print(f"Error: user '{username}' not found. Use --list to see users.")
        rec.update(password_hash=auth._hash(password), pw_changed=auth._now(),
                   updated_at=auth._now(), active=True, must_change_password=False)
        auth._write(data)
    print(f"Password for '{username}' reset (account active). Existing sessions are logged out.")


if __name__ == "__main__":
    main()