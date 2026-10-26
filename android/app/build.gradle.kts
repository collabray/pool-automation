plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val serverUrl: String = (project.findProperty("serverUrl") as String).trimEnd('/')
require(serverUrl.startsWith("https://")) { "serverUrl must start with https:// (cleartext HTTP is disabled in this app)" }

android {
    namespace = "com.pooltable.owner"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.pooltable.owner"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
        buildConfigField("String", "SERVER_HOST", "\"${java.net.URI(serverUrl).host}\"")
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        create("release") {
            // Provide with: -Pkeystore=/path/owner.jks -PkeystorePassword=... -PkeyAlias=owner -PkeyPassword=...
            val ks = project.findProperty("keystore") as String?
            if (ks != null) {
                storeFile = file(ks)
                storePassword = project.findProperty("keystorePassword") as String?
                keyAlias = project.findProperty("keyAlias") as String?
                keyPassword = project.findProperty("keyPassword") as String?
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (project.findProperty("keystore") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.biometric:biometric:1.1.0")
}
