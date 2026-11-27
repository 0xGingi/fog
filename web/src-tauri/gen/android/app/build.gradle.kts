import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    // Android 17 QPR2 (API 37.2), the newest stable SDK.
    compileSdk = 37
    compileSdkMinor = 2
    // Release builds are signed with the keystore CI decodes from repository secrets (never committed).
    signingConfigs {
        create("release") {
            System.getenv("FOG_ANDROID_KEYSTORE")?.let { path ->
                storeFile = file(path)
                storePassword = System.getenv("FOG_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("FOG_ANDROID_KEY_ALIAS") ?: "fog"
                keyPassword = System.getenv("FOG_ANDROID_KEY_PASSWORD") ?: System.getenv("FOG_ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }
    namespace = "org.getfog.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "org.getfog.app"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (System.getenv("FOG_ANDROID_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
    // Google Play build (FOG_PLAY=1): no self-updating from GitHub, which Play doesn't allow.
    if (System.getenv("FOG_PLAY") != null) sourceSets.getByName("release").manifest.srcFile("src/play/AndroidManifest.xml")
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("com.google.android.material:material:1.14.0")
    implementation("androidx.lifecycle:lifecycle-process:2.11.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// Push notifications: CI writes google-services.json from a secret. Without it the app still builds,
// and simply notifies only while it's open.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")
