FROM gradle:8.7-jdk17 AS build

USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline.zip \
    && unzip -q /tmp/cmdline.zip -d /tmp/android-cli \
    && mv /tmp/android-cli/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/cmdline.zip /tmp/android-cli

RUN yes | sdkmanager --sdk_root=${ANDROID_HOME} --licenses >/dev/null \
    && sdkmanager --sdk_root=${ANDROID_HOME} "platforms;android-35" "build-tools;35.0.0"

WORKDIR /workspace
COPY android-pos/ /workspace/
RUN mkdir -p /workspace/app/src/main/res/drawable-nodpi
COPY branding/inyou-official.webp /workspace/app/src/main/res/drawable-nodpi/inyou_official.webp
RUN gradle assembleDebug --no-daemon \
    && cp app/build/outputs/apk/debug/app-debug.apk /tmp/INYOU-Water-POS-v1.2.3.apk

FROM python:3.12-alpine
WORKDIR /app
COPY --from=build /tmp/INYOU-Water-POS-v1.2.3.apk /app/INYOU-Water-POS-v1.2.3.apk
RUN printf '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Water POS APK</title></head><body style="font-family:sans-serif;padding:30px"><h1>INYOU Water POS Android v1.2.3</h1><p>Official INYOU Water POS app with approved branding, 5-second water loading splash, Huawei/EMUI kiosk hardening, logout, Exit App, and dedicated Device Owner lock.</p><p><a href="/INYOU-Water-POS-v1.2.3.apk">Download INYOU-Water-POS-v1.2.3.apk</a></p></body></html>' > /app/index.html
EXPOSE 8080
CMD ["python", "-m", "http.server", "8080", "--bind", "0.0.0.0"]
