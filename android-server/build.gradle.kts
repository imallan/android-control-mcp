import org.gradle.api.GradleException
import org.gradle.api.tasks.Delete
import org.gradle.api.tasks.Exec
import java.util.Properties

data class VersionedDirectory(val dir: File, val numbers: List<Int>, val suffix: String)

fun readLocalProperties(): Properties {
  val properties = Properties()
  val localPropertiesFile = file("local.properties")
  if (localPropertiesFile.exists()) {
    localPropertiesFile.inputStream().use { properties.load(it) }
  }
  return properties
}

fun parseVersion(name: String, prefix: String): VersionedDirectory? {
  if (!name.startsWith(prefix)) {
    return null
  }

  val rawVersion = name.removePrefix(prefix)
  val numericPrefix = rawVersion.takeWhile { it.isDigit() || it == '.' }
  if (numericPrefix.isEmpty()) {
    return null
  }

  val suffix = rawVersion.removePrefix(numericPrefix).trimStart('-', '_')
  val numbers = numericPrefix.split('.').map { it.toIntOrNull() ?: 0 }
  return VersionedDirectory(File(name), numbers, suffix)
}

fun compareVersions(left: VersionedDirectory, right: VersionedDirectory): Int {
  val maxSize = maxOf(left.numbers.size, right.numbers.size)
  for (index in 0 until maxSize) {
    val leftPart = left.numbers.getOrElse(index) { 0 }
    val rightPart = right.numbers.getOrElse(index) { 0 }
    if (leftPart != rightPart) {
      return leftPart.compareTo(rightPart)
    }
  }

  val leftIsStable = left.suffix.isEmpty()
  val rightIsStable = right.suffix.isEmpty()
  if (leftIsStable != rightIsStable) {
    return if (leftIsStable) 1 else -1
  }

  return left.suffix.compareTo(right.suffix)
}

fun resolveSdkRoot(): File {
  val localPropertiesSdkDir = readLocalProperties().getProperty("sdk.dir")?.trim()?.takeIf { it.isNotEmpty() }?.let(::File)
  val candidates = listOfNotNull(
    providers.environmentVariable("ANDROID_SDK_ROOT").orNull?.trim()?.takeIf { it.isNotEmpty() }?.let(::File),
    providers.environmentVariable("ANDROID_HOME").orNull?.trim()?.takeIf { it.isNotEmpty() }?.let(::File),
    localPropertiesSdkDir,
    File(System.getProperty("user.home"), "Library/Android/sdk")
  )

  return candidates.firstOrNull { it.exists() } ?: throw GradleException(
    "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME, or define sdk.dir in local.properties."
  )
}

fun resolveLatestDirectory(root: File, prefix: String, requiredFiles: List<String>): File? {
  val directories = root.listFiles()
    ?.asSequence()
    ?.filter { it.isDirectory }
    ?.filter { directory -> requiredFiles.all { directory.resolve(it).exists() } }
    ?.mapNotNull { directory ->
      parseVersion(directory.name, prefix)?.copy(dir = directory)
    }
    ?.toList()
    .orEmpty()

  return directories.maxWithOrNull(::compareVersions)?.dir
}

val sdkRoot = resolveSdkRoot()

val androidPlatform: String =
  providers.environmentVariable("ANDROID_PLATFORM")
    .orElse("android-36")
    .get()

val androidBuildTools: String =
  providers.environmentVariable("ANDROID_BUILD_TOOLS")
    .orElse("")
    .get()

val defaultKotlinc = "/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc"
val kotlincPath: String =
  providers.environmentVariable("KOTLINC")
    .orElse(defaultKotlinc)
    .get()

val platformDir =
  if (providers.environmentVariable("ANDROID_PLATFORM").orNull.isNullOrBlank()) {
    resolveLatestDirectory(sdkRoot.resolve("platforms"), "android-", listOf("android.jar", "uiautomator.jar"))
      ?: throw GradleException(
        "Android platform not found under ${sdkRoot.resolve("platforms").path}. Set ANDROID_PLATFORM explicitly."
      )
  } else {
    sdkRoot.resolve("platforms").resolve(androidPlatform)
  }

val buildToolsDir =
  if (providers.environmentVariable("ANDROID_BUILD_TOOLS").orNull.isNullOrBlank()) {
    val latest = resolveLatestDirectory(sdkRoot.resolve("build-tools"), "", listOf("d8"))
      ?: throw GradleException(
        "No build-tools installation with d8 found under ${sdkRoot.resolve("build-tools").path}. Install Android build-tools or set ANDROID_BUILD_TOOLS."
      )
    latest
  } else {
    sdkRoot.resolve("build-tools").resolve(androidBuildTools)
  }

val androidJar = platformDir.resolve("android.jar")
val uiautomatorJar = platformDir.resolve("uiautomator.jar")
val d8 = buildToolsDir.resolve("d8")
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
