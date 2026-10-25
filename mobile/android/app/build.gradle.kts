// Android 版 (2026-10-25)。中身は iPhone 版と同じく Web (../../dist) を WebView で動かし、
// src/native/contract.ts の約束 (Bluetooth Classic・保存など) だけを Kotlin で作る
plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.oud0n.laploupe"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.oud0n.dsuniversal"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 試してくれる人に配る版は、手元の鍵で署名する (keystore.properties があるとき。無ければ debug の鍵)
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets {
        // アプリに入れる Web (npm run build で作る dist) を assets/web として入れる
        getByName("main").assets.srcDir(file("build/webAssets"))
    }
}

val copyWeb by tasks.registering(Copy::class) {
    val dist = rootProject.file("../../dist")
    doFirst {
        if (!dist.resolve("index.html").exists()) throw GradleException("dist がありません。先に npm run build を (リポジトリの一番上で)")
    }
    from(dist)
    into(file("build/webAssets/web"))
}
tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
}
