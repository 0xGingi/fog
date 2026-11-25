import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.getfog.plugin"
    compileSdk = 37
    compileSdkMinor = 2
    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.appcompat:appcompat:1.8.0")
    // Push: Firebase Cloud Messaging only (no analytics). Needs Google Play services on the phone.
    implementation("com.google.firebase:firebase-messaging:26.0.2")
    implementation(project(":tauri-android"))
}
