require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PounceAppearance'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'Pounce'
  s.homepage       = 'https://github.com/pounce-ai/pounce'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => '' }
  s.swift_version  = '5.9'
  s.source_files   = '*.swift'
  s.dependency 'ExpoModulesCore'
end
