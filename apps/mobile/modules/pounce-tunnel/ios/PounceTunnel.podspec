require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PounceTunnel'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'Pounce'
  s.homepage       = 'https://github.com/peppyhop/pounce'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => '' }
  s.swift_version  = '5.9'
  s.source_files   = '*.swift'
  # Rust staticlib (apps/tunnel) wrapped as a static-framework xcframework —
  # rebuild with apps/tunnel/build-ios.sh after Rust changes.
  s.vendored_frameworks = 'PounceTunnelCore.xcframework'
  s.dependency 'ExpoModulesCore'
end
