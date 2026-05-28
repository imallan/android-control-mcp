import org.gradle.api.GradleException
import org.gradle.api.tasks.Delete
import org.gradle.api.tasks.Exec

val sdkRoot: String =
  providers.environmentVariable("ANDROID_HOME")
    .orElse(providers.environmentVariable("ANDROID_SDK_ROOT"))
    .orElse("/Volumes/数据/Android/sdk")
    .get()

val androidPlatform: String =
  providers.environmentVariable("ANDROID_PLATFORM")
    .orElse("android-36")
    .get()

val androidBuildTools: String =
  providers.environmentVariable("ANDROID_BUILD_TOOLS")
    .orElse("37.0.0")
    .get()

val defaultKotlinc = "/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc"
val kotlincPath: String =
  providers.environmentVariable("KOTLINC")
    .orElse(defaultKotlinc)
    .get()

val androidJar = file("$sdkRoot/platforms/$androidPlatform/android.jar")
val uiautomatorJar = file("$sdkRoot/platforms/$androidPlatform/uiautomator.jar")
val d8 = file("$sdkRoot/build-tools/$androidBuildTools/d8")
val kotlinc = file(kotlincPath)
val kotlinHome = kotlinc.parentFile.parentFile
val kotlinStdlib = file("${kotlinHome.path}/lib/kotlin-stdlib.jar")

val generatedStubDir = layout.buildDirectory.dir("generated/stubs")
val classesDir = layout.buildDirectory.dir("classes")
val dexDir = layout.buildDirectory.dir("dex")
val rawJar = layout.buildDirectory.file("android-ui-server-classes.jar")
val finalJar = layout.buildDirectory.file("android-ui-server.jar")

tasks.register<Delete>("clean") {
  group = "build"
  description = "Deletes Android UIAutomator server build outputs."
  delete(layout.buildDirectory)
}

fun requireFile(path: File, label: String) {
  if (!path.exists()) {
    throw GradleException("$label not found: ${path.path}")
  }
}

tasks.register("prepareJunitStub") {
  outputs.file(generatedStubDir.map { it.file("junit/framework/TestCase.java") })

  doLast {
    val stub = generatedStubDir.get().file("junit/framework/TestCase.java").asFile
    stub.parentFile.mkdirs()
    stub.writeText(
      """
      package junit.framework;

      public class TestCase {
        protected void setUp() throws Exception {}
        protected void tearDown() throws Exception {}
      }
      """.trimIndent()
    )
  }
}

tasks.register<Exec>("compileJunitStub") {
  dependsOn("prepareJunitStub")
  outputs.dir(classesDir)

  doFirst {
    requireFile(androidJar, "android.jar")
    delete(classesDir)
    classesDir.get().asFile.mkdirs()
  }

  commandLine(
    "javac",
    "-source",
    "8",
    "-target",
    "8",
    "-bootclasspath",
    androidJar.path,
    "-d",
    classesDir.get().asFile.path,
    generatedStubDir.get().file("junit/framework/TestCase.java").asFile.path
  )
}

tasks.register<Exec>("compileKotlinServer") {
  dependsOn("compileJunitStub")
  inputs.files(fileTree("src") { include("**/*.kt") })
  outputs.dir(classesDir)

  doFirst {
    requireFile(kotlinc, "kotlinc")
    requireFile(androidJar, "android.jar")
    requireFile(uiautomatorJar, "uiautomator.jar")
    requireFile(kotlinStdlib, "kotlin-stdlib.jar")
  }

  val sourceFiles = fileTree("src") { include("**/*.kt") }.files.sortedBy { it.path }
  commandLine(
    kotlinc.path,
    "-jvm-target",
    "1.8",
    "-classpath",
    listOf(androidJar, uiautomatorJar, classesDir.get().asFile).joinToString(File.pathSeparator) { it.path },
    "-d",
    classesDir.get().asFile.path,
    *sourceFiles.map { it.path }.toTypedArray()
  )
}

tasks.register<Exec>("dexUiautomatorServer") {
  dependsOn("jarKotlinClasses")
  outputs.dir(dexDir)

  doFirst {
    requireFile(d8, "d8")
    delete(dexDir.get().asFile)
    dexDir.get().asFile.mkdirs()
  }

  commandLine(
    d8.path,
    "--classpath",
    androidJar.path,
    "--classpath",
    uiautomatorJar.path,
    "--min-api",
    "23",
    "--output",
    dexDir.get().asFile.path,
    rawJar.get().asFile.path,
    kotlinStdlib.path
  )
}

tasks.register<Exec>("jarKotlinClasses") {
  dependsOn("compileKotlinServer")
  outputs.file(rawJar)

  doFirst {
    delete(rawJar.get().asFile)
  }

  commandLine(
    "jar",
    "cf",
    rawJar.get().asFile.path,
    "-C",
    classesDir.get().asFile.path,
    "."
  )
}

tasks.register<Exec>("buildUiautomatorJar") {
  group = "build"
  description = "Builds build/android-ui-server.jar for adb shell uiautomator runtest."
  dependsOn("dexUiautomatorServer")
  outputs.file(finalJar)

  doFirst {
    delete(finalJar.get().asFile)
  }

  commandLine(
    "jar",
    "cf",
    finalJar.get().asFile.path,
    "-C",
    dexDir.get().asFile.path,
    "classes.dex"
  )
}
