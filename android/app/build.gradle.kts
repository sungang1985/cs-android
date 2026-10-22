import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.csandroid.strike"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.csandroid.strike"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The web build (dist/) is copied into src/main/assets/www by `npm run build:android`
    // (see tools/sync-android.mjs). Keep the folder out of git; it is generated.
    sourceSets.getByName("main").assets.srcDirs("src/main/assets")
}

// Fail early with a helpful message if the web bundle has not been synced into assets.
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    doFirst {
        val www = file("src/main/assets/www/index.html")
        if (!www.exists()) {
            throw GradleException(
                "Web bundle missing: ${www}. Run `npm install && npm run build:android` in the repository root first."
            )
        }
    }
}

dependencies {
    // Intentionally no AndroidX/Jetpack dependencies: the wrapper only needs the platform WebView.
}
