# Pool Owner Android app

A small, hardened Android wrapper around the owner web app (`/owner.html` on your server). It adds a fingerprint/PIN lock,
blocks screenshots, only talks to your server over HTTPS, and re-locks whenever you leave the app.

**You do not strictly need this.** The same web app is a Progressive Web App: open `https://YOUR-DOMAIN/owner.html` in Chrome on the
owner's phone → ⋮ → *Install app* / *Add to Home screen*. This Android project exists for owners who want a "real" APK with a lock.

> Status: this source has **not been compiled or run** by the author (the build environment had no Android SDK). Treat the first build as a test.

## Build (Android Studio, easiest)
1. Install Android Studio. *File → Open* this `android/` folder. Let it sync (it downloads Gradle and the SDK).
2. Edit `gradle.properties`: set `serverUrl=https://YOUR-DOMAIN`.
3. *Build → Build APK(s)*. The debug APK appears in `app/build/outputs/apk/debug/`.

## Build a signed release APK (command line)
```
keytool -genkeypair -v -keystore owner.jks -alias owner -keyalg RSA -keysize 2048 -validity 10000
gradle wrapper            # once, if there is no ./gradlew yet (needs Gradle installed), or let Android Studio create it
./gradlew assembleRelease -PserverUrl=https://YOUR-DOMAIN -Pkeystore=owner.jks -PkeystorePassword=... -PkeyAlias=owner -PkeyPassword=...
```
Output: `app/build/outputs/apk/release/app-release.apk`. Keep `owner.jks` and its passwords backed up OFFLINE; you cannot update the app without it.

## Install on the owner's phone
Copy the APK to the phone (USB/Drive), open it, allow "install from this source" when asked. Sign in once; the app remembers you.
